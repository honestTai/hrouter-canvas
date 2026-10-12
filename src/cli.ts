#!/usr/bin/env node
import { canvasUrl, ensureDaemon, openCanvas, request } from './client.ts';
import { DEFAULT_PORT, home, VERSION } from './config.ts';
import { AlreadyRunning, probe, startDaemon } from './daemon.ts';
import { runMcp } from './mcp.ts';

const HELP = `hrouter-canvas ${VERSION}
Infinite-canvas image generation for coding agents.

Usage: hrouter-canvas [command]

  mcp       Run the MCP server over stdio (default; this is what agents launch)
  open      Start the local canvas if needed and open it in the browser
  url       Print the canvas address including the local access token
  status    Show whether the local canvas service is running
  stop      Stop the local canvas service
  serve     Run the canvas service in the foreground

Data and settings live in ${home()}
`;

async function main(): Promise<void> {
  const command = process.argv[2] || 'mcp';
  if (command === '--version' || command === '-v') return void console.log(VERSION);
  if (command === '--help' || command === '-h' || command === 'help') return void console.log(HELP);
  if (command === 'mcp') return runMcp();
  if (command === 'serve') {
    try {
      const daemon = await startDaemon();
      console.error(`${new Date().toISOString()} hrouter-canvas ${VERSION} on ${daemon.url}`);
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => void daemon.close().then(() => process.exit(0)));
    } catch (error) {
      // Another session won the race to start the shared service; that one will be used.
      if (error instanceof AlreadyRunning) return;
      throw error;
    }
    return;
  }
  if (command === 'open') {
    const port = await ensureDaemon();
    const result = await openCanvas(port, true);
    return void console.log(result === 'opened' ? canvasUrl(port) : canvasUrl(port, true));
  }
  if (command === 'url') return void console.log(canvasUrl(await ensureDaemon(), true));
  if (command === 'status' || command === 'stop') {
    const port = Number(process.env.HROUTER_CANVAS_PORT) || DEFAULT_PORT;
    let found = 0;
    for (let candidate = port; candidate < port + 10 && !found; candidate++)
      if (await probe(candidate)) found = candidate;
    if (!found) return void console.log('画布服务未运行');
    if (command === 'status') {
      const info = await probe(found);
      return void console.log(`画布服务运行中：${canvasUrl(found)}（版本 ${info?.version}，${info?.viewers} 个页面已打开）`);
    }
    await request(found, 'shutdown', { method: 'POST' });
    return void console.log('画布服务已停止');
  }
  console.error(HELP);
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
