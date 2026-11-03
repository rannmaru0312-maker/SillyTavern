#!/usr/bin/env node
'use strict';
// Synthetic-only portable backup proof of concept. Not approved for real user data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, openSync, closeSync } = fs;
const MAX = 1024 * 1024; // bounded fixture files
function fail(message) { throw new Error(message); }
function safeFile(name) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(name) || name === 'manifest.json' || name.includes('..')) fail('Unsafe filename'); }
function sha(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function files(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (!entries.length) fail('No fixture files');
  return entries.map(e => {
    safeFile(e.name);
    if (!e.isFile() || e.isSymbolicLink()) fail('Only regular JSON files supported');
    const full = path.join(directory, e.name);
    const s = lstatSync(full); if (s.size > MAX || s.nlink !== 1) fail('Unsafe file size or hardlink');
    const raw = readFileSync(full);
    let parsed; try { parsed = JSON.parse(raw.toString('utf8')); } catch { fail('Invalid JSON'); }
    if (parsed.synthetic !== true) fail('Not synthetic data. Production use prohibited');
    return { name:e.name, content:raw, size:raw.length, sha256:sha(raw) };
  }).sort((a,b)=>a.name.localeCompare(b.name,'en'));
}
function ensureEmptyDir(target) {
  if (fs.existsSync(target)) fail('Refusing to overwrite target');
  mkdirSync(target, {recursive:false, mode:0o700});
}
function saveNew(dir,name,raw) {
  const fd=openSync(path.join(dir,name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd,raw); fs.fsyncSync(fd); } finally { closeSync(fd); }
}
function pack(src, dest) {
  const data=files(src); ensureEmptyDir(dest);
  try {
    const manifest={schema_version:1,format:'miya-synthetic-backup',synthetic_only:true,created_at:new Date().toISOString(),files:data.map(({name,size,sha256})=>({name,size,sha256}))};
    for(const file of data) saveNew(dest,file.name,file.content);
    saveNew(dest,'manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
    return manifest;
  } catch(e) { fs.rmSync(dest,{recursive:true,force:true}); throw e; }
}
function verify(dir) {
  const mf=path.join(dir,'manifest.json');
  if (!lstatSync(mf).isFile() || lstatSync(mf).isSymbolicLink()) fail('Unsafe manifest');
  const manifest=JSON.parse(readFileSync(mf,'utf8'));
  if(manifest.schema_version!==1 || manifest.format!=='miya-synthetic-backup' || manifest.synthetic_only!==true || !Array.isArray(manifest.files) || !manifest.files.length) fail('Invalid manifest');
  const expected=new Set(['manifest.json']);
  for (const item of manifest.files) {
    if(!item || typeof item.name!=='string') fail('Invalid entry');
    safeFile(item.name);
    if(expected.has(item.name)) fail('Duplicate entry');
    expected.add(item.name);
    const p=path.join(dir,item.name), stat=lstatSync(p);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>MAX || stat.size!==item.size) fail('Invalid entry size or type: '+item.name);
    const raw=readFileSync(p);
    if (sha(raw)!==item.sha256) fail('Hash mismatch: '+item.name);
    let doc; try {doc=JSON.parse(raw.toString('utf8'));}catch{fail('Invalid fixture JSON');}
    if(doc.synthetic!==true) fail('Real data forbidden');
  }
  const actual=readdirSync(dir);
  if(actual.length!==expected.size || actual.some(name=>!expected.has(name))) fail('Extra or missing files');
  return manifest;
}
function restore(source,dest) {
  const manifest=verify(source); ensureEmptyDir(dest);
  try {
    for(const item of manifest.files) saveNew(dest,item.name,readFileSync(path.join(source,item.name)));
    const restored=files(dest);
    if(restored.length!==manifest.files.length || restored.some((x,i)=>x.name!==manifest.files[i].name || x.sha256!==manifest.files[i].sha256)) fail('Restore validation failed');
  } catch(e) {fs.rmSync(dest,{recursive:true,force:true});throw e;}
  return manifest;
}
function main(argv) {
  const [cmd,source,dest]=argv;
  if(!['pack','verify','restore'].includes(cmd) || !source || (cmd!=='verify' && !dest) || (cmd==='verify' && dest)) fail('Usage: node portable-backup.cjs pack SOURCE NEW_DIR | verify BACKUP_DIR | restore BACKUP_DIR NEW_DIR');
  const result=cmd==='pack'?pack(source,dest):cmd==='verify'?verify(source):restore(source,dest);
  process.stdout.write(JSON.stringify({ok:true,action:cmd,file_count:result.files.length})+'\n');
}
if(require.main===module) {try{main(process.argv.slice(2));}catch(err){console.error(err.message);process.exitCode=1;}}
module.exports={pack,verify,restore};
