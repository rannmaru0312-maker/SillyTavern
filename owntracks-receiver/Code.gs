// MIYA OwnTracks storage bridge. Do NOT use this URL directly in OwnTracks.
// Script Properties: BRIDGE_SECRET (64 hex), OUTPUT_FOLDER_ID, ENABLED=true.
// Use a separate deployment/properties for synthetic testing. No public read API.
function doGet() { return json_({service:'miya-owntracks-storage',ready:false}); }
function doPost(e) {
  try {
    var props=PropertiesService.getScriptProperties();
    var secret=props.getProperty('BRIDGE_SECRET');
    if(props.getProperty('ENABLED')!=='true'||!secret||!/^[a-f0-9]{64}$/.test(secret))return json_({ok:false});
    var raw=e&&e.postData&&e.postData.contents;
    if(typeof raw!=='string'||raw.length>40000)return json_({ok:false});
    var env=JSON.parse(raw);
    if(env.version!==1||typeof env.data!=='string'||env.data.length>32768||!Number.isSafeInteger(env.sentAt)||Math.abs(Date.now()/1000-env.sentAt)>300)return json_({ok:false});
    var signed=hex_(Utilities.computeHmacSha256Signature(env.sentAt+'\n'+env.data,secret));
    if(!equal_(signed,env.signature))return json_({ok:false});
    var p=JSON.parse(env.data);
    if(!p||!['location','transition'].includes(p._type)||!Number.isSafeInteger(p.tst)||p.tst<946684800||p.tst>Date.now()/1000+600)return json_({ok:false});
    if(typeof p.lat!=='number'||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||typeof p.lon!=='number'||!Number.isFinite(p.lon)||Math.abs(p.lon)>180)return json_({ok:false});
    if(p._type==='transition'&&!['enter','leave'].includes(p.event))return json_({ok:false});
    var digest=hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,env.data));
    var folderId=props.getProperty('OUTPUT_FOLDER_ID');
    if(!folderId)return json_({ok:false});
    var lock=LockService.getScriptLock();
    if(!lock.tryLock(5000))return json_({ok:false});
    try {
      var folder=DriveApp.getFolderById(folderId);
      if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE)return json_({ok:false});
      var day=Utilities.formatDate(new Date(p.tst*1000),'Asia/Tokyo','yyyy-MM-dd');
      var name='owntracks_'+day+'.json';
      var files=folder.getFilesByName(name),file=null;
      if(files.hasNext()){file=files.next();if(files.hasNext())return json_({ok:false});}
      var doc={version:1,source:'owntracks',timezone:'Asia/Tokyo',coverageVerified:false,date:day,events:[]};
      if(file){
        if(file.getSharingAccess()!==DriveApp.Access.PRIVATE||file.getSize()>5000000)return json_({ok:false});
        doc=JSON.parse(file.getBlob().getDataAsString('UTF-8'));
        if(doc.version!==1||doc.source!=='owntracks'||doc.date!==day||!Array.isArray(doc.events))return json_({ok:false});
      }
      var old=doc.events.find(function(x){return x.id===digest;});
      if(old){if(old.canonical!==env.data)return json_({ok:false});return json_({ok:true,sha256:digest,fileId:file.getId()});}
      if(doc.events.length>=5000)return json_({ok:false});
      doc.events.push({id:digest,receivedAt:new Date().toISOString(),confirmation:'GPS推定・本人未確認',canonical:env.data,payload:p});
      var text=JSON.stringify(doc);
      if(text.length>5000000)return json_({ok:false});
      if(file)file.setContent(text);else file=folder.createFile(name,text,MimeType.PLAIN_TEXT);
      if(file.getBlob().getDataAsString('UTF-8')!==text)return json_({ok:false});
      return json_({ok:true,sha256:digest,fileId:file.getId()});
    } finally {lock.releaseLock();}
  }catch(error){return json_({ok:false});}
}
function hex_(bytes){return bytes.map(function(b){return ('0'+(b&255).toString(16)).slice(-2);}).join('');}
function equal_(a,b){if(typeof b!=='string'||b.length!==a.length)return false;var diff=0;for(var i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
