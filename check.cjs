const { Innertube, ClientType } = require('youtubei.js');

(async () => {
  const yt = await Innertube.create();

  console.log('=== YT Music search ===');
  const results = await yt.music.search("Niko B Why's this dealer?", { type: 'song' });
  for (const item of results?.songs?.contents ?? []) {
    console.log(item.id, '|', item.title, '|', item.artists?.map(a => a.name).join(', '));
  }

  console.log('\n=== getInfo: MV id (SerTJpflwMM) ===');
  try {
    const mv = await yt.getInfo('SerTJpflwMM');
    console.log({
      status: mv.playability_status?.status,
      reason: mv.playability_status?.reason,
      title: mv.basic_info?.title,
      channel: mv.basic_info?.channel?.name,
    });
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  console.log('\n=== getInfo: YTM upload id (W_qNvDLDHd0) ===');
  try {
    const ytm = await yt.getInfo('W_qNvDLDHd0');
    console.log({
      status: ytm.playability_status?.status,
      reason: ytm.playability_status?.reason,
      title: ytm.basic_info?.title,
      channel: ytm.basic_info?.channel?.name,
    });
  } catch (e) {
    console.log('FAILED:', e.message);
  }
})();