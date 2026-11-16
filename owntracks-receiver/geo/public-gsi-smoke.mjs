/**
 * Single-request GSI connectivity smoke test from a public CI runner.
 * Coordinates are the public Tokyo Station landmark. NO user GPS data.
 * This file does not run unless MIYA_PUBLIC_GSI_SMOKE=1 is set.
 */
const PUBLIC_GSI_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=35.681236&lon=139.767125';

export async function smokeGsiPublic(fetcher = fetch) {
  const reply = await fetcher(PUBLIC_GSI_URL, {
    method:'GET',
    redirect:'error',
    headers: {'Accept':'application/json', 'User-Agent':'MIYA-GPS-Public-Smoke/0.1 (+https://github.com/rannmaru0312-maker/SillyTavern)'},
    signal: AbortSignal.timeout(10000),
  });
  if (!reply?.ok) throw Error(`gsi_http_${reply?.status ?? 'missing'}`);
  const size=Number(reply.headers?.get('content-length') || 0);
  if (size>4096) throw Error('unexpected_large_response');
  const body=await reply.text();
  if (body.length>4096) throw Error('unexpected_large_response');
  const data=JSON.parse(body);
  const result=data?.results;
  if (!/^\d{5}$/.test(result?.muniCd) || !result?.lv01Nm || typeof result.lv01Nm!=='string') {
    throw Error('gsi_unexpected_payload');
  }
  return {provider:'GSI',responded:true,municipalityCode:result.muniCd,neighborhood:result.lv01Nm};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.MIYA_PUBLIC_GSI_SMOKE !== '1') {
    console.log('SKIP: public GSI connectivity test is disabled. No outbound requests.');
  } else {
    try {
      const result=await smokeGsiPublic();
      console.log('PASS: verified public Tokyo Station GSI response:',JSON.stringify(result));
    } catch(e) {
      console.error('UNAVAILABLE: public GSI smoke test did not complete:',String(e?.message||e));
      process.exitCode=2;
    }
  }
}