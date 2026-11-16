import { SendPacer } from '../notifier/sendPacer.js';

const recipientCount = 60;
const simulatedTelegramLatencyMs = 60;
const pacingIntervalMs = 35;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSerial(): Promise<number> {
  const startedAt = performance.now();
  for (let index = 0; index < recipientCount; index++) {
    await delay(simulatedTelegramLatencyMs);
    if (index < recipientCount - 1) await delay(pacingIntervalMs);
  }
  return performance.now() - startedAt;
}

async function runPaced(): Promise<number> {
  const pacer = new SendPacer(pacingIntervalMs);
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: recipientCount }, () =>
    pacer.run(() => delay(simulatedTelegramLatencyMs))
  ));
  return performance.now() - startedAt;
}

const serialMs = await runSerial();
const pacedMs = await runPaced();
console.log(`Synthetic recipients: ${recipientCount}; simulated API latency: ${simulatedTelegramLatencyMs} ms; pacing: ${pacingIntervalMs} ms`);
console.log(`Serial delivery: ${serialMs.toFixed(0)} ms`);
console.log(`Paced concurrent delivery: ${pacedMs.toFixed(0)} ms`);
console.log(`Speedup: ${(serialMs / pacedMs).toFixed(2)}x`);
