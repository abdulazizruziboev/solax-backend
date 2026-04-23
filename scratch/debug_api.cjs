const tokenId = '20260421144334184087555';
const devices = ['SRYTWFFXD8', 'SSJZHSXT2P', 'SS9QAGQTQ7']; // Some more "Offline" in our DB

async function check() {
  for (const sn of devices) {
    console.log(`Fetching ${sn}...`);
    try {
      const res = await fetch(`https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${tokenId}&sn=${sn}`);
      const json = await res.json();
      console.log(`${sn} STATUS:`, json.result?.inverterStatus, 'UPLOAD:', json.result?.uploadTime);
    } catch (e) {
      console.error(e);
    }
  }
}

check();
