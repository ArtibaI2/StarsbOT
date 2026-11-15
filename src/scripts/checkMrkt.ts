import axios from 'axios';

async function main() {
  try {
    const res = await axios.get('https://t.me/mrkt/app');
    const m = res.data.match(/"url":"([^"]+)"/);
    console.log('App URL match:', m ? m[1] : 'not found');
    const m2 = res.data.match(/https?:\/\/[a-zA-Z0-9.-]+\.[a-z]{2,}[^\s"'<>]*/g) || [];
    console.log('All URLs:', Array.from(new Set(m2)));
  } catch (e: any) {
    console.error('Error:', e.message);
  }
}

main();
