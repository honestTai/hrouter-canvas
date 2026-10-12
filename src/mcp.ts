import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canvasUrl, ensureDaemon, openCanvas, request, type OpenResult } from './client.ts';
import { applyEnvSite, HttpError, VERSION } from './config.ts';

const INSTRUCTIONS = `HRouter Canvas gives you image generation plus an infinite canvas the user can see.
Use generate_image whenever the user asks you to draw, generate, create, design or edit an image
(画图、生图、出图、做海报、图标、logo、插画、配图、改图、P 图) and you have no native image
generation ability of your own, or whenever the user mentions the canvas (画布). Results are saved
as real files and appear on the canvas, which opens in the user's browser automatically.
Image sites and API keys are configured only by the user, on the canvas settings page. Never ask
the user to paste an API key into the chat, and never try to set one yourself.`;

const where = (open: OpenResult, url: string) =>
  open === 'opened'
    ? `Canvas opened in the user's browser: ${url}`
    : open === 'already-open'
      ? `Canvas is already open in the user's browser and now shows the result: ${url}`
      : open === 'headless'
        ? `No browser here (remote or headless session). The canvas is at ${url} on this machine; the user can run \`npx hrouter-canvas-mcp url\` for a link that includes access.`
        : `Could not launch a browser. The user can run \`npx hrouter-canvas-mcp open\`.`;
const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

async function failure(error: unknown, port?: number) {
  const message = error instanceof Error ? error.message : String(error);
  // 409 means the user has setup to do; take them to the settings page instead of failing blind.
  if (error instanceof HttpError && error.status === 409 && port) {
    const open = await openCanvas(port, true, 'settings');
    return text(
      `${message}\n\nThe user must add an image site and API key on the canvas settings page (never in chat). ${where(open, canvasUrl(port))}\nAsk them to finish that, then call this tool again.`,
      true,
    );
  }
  return text(`Image generation failed: ${message}`, true);
}

export async function runMcp(): Promise<void> {
  applyEnvSite();
  const server = new McpServer(
    { name: 'hrouter-canvas', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate or edit an image',
      description:
        'Generate an image from a text prompt, or edit/restyle existing images when reference_images are given. Use this for any request to draw, create or modify an image when you cannot generate images natively. The result is saved to disk (absolute paths are returned) and shown on the user\'s infinite canvas. Write the prompt in the user\'s language with concrete subject, style, composition and any text that must appear. Generation can take from several seconds to a few minutes and may cost the user money, so do not call it repeatedly for the same request unless asked.',
      inputSchema: {
        prompt: z.string().min(1).max(8000).describe('What to draw, or how to change the reference images.'),
        aspect_ratio: z
          .string()
          .regex(/^\d{1,4}:\d{1,4}$/)
          .optional()
          .describe('Width:height such as 1:1, 16:9, 9:16, 3:2, 2:3. Omit to let the model decide.'),
        resolution: z
          .enum(['1K', '2K', '4K'])
          .optional()
          .describe('Only honoured by models that support it (for example Gemini image models). Omit by default.'),
        reference_images: z
          .array(z.string())
          .max(8)
          .optional()
          .describe('Absolute file paths, or image ids from a previous result, to edit or use as visual reference.'),
        count: z.number().int().min(1).max(4).optional().describe('How many variations to generate. Default 1.'),
        save_to: z
          .string()
          .optional()
          .describe('Absolute directory or file path to also copy the result into, e.g. the project\'s assets folder. Existing files are never overwritten.'),
        model: z.string().optional().describe('Model id from list_image_models. Omit to use the user\'s default.'),
        site: z.string().optional().describe('Site id or name from list_image_models. Omit to use the user\'s default.'),
      },
    },
    async (input) => {
      let port: number | undefined;
      try {
        port = await ensureDaemon();
        // Open first so the user watches the placeholder turn into the picture.
        const opening = openCanvas(port);
        const result = await request(port, 'generate', {
          body: {
            prompt: input.prompt,
            aspectRatio: input.aspect_ratio,
            resolution: input.resolution,
            references: input.reference_images,
            count: input.count,
            saveTo: input.save_to,
            model: input.model,
            site: input.site,
          },
        });
        const lines = result.images.map(
          (image: { id: string; path: string; savedTo?: string; width: number; height: number }) =>
            `- ${image.savedTo || image.path} (${image.width}×${image.height}, id ${image.id})` +
            (image.savedTo ? `\n  canvas copy: ${image.path}` : ''),
        );
        return text(
          [
            `Generated ${result.images.length} image(s) with ${result.model} via ${result.site}:`,
            ...lines,
            ...result.errors.map((e: string) => `- one variation failed: ${e}`),
            where(await opening, canvasUrl(port)),
            'Tell the user where the file is. Do not paste the image bytes or re-generate unless asked.',
          ].join('\n'),
        );
      } catch (error) {
        return failure(error, port);
      }
    },
  );

  server.registerTool(
    'open_canvas',
    {
      title: 'Open the image canvas',
      description:
        'Open the infinite canvas in the user\'s browser so they can view, arrange, compare and keep creating images, or open its settings page to configure image sites and API keys. Use when the user asks to see the canvas or needs to set up a site.',
      inputSchema: {
        settings: z.boolean().optional().describe('Open the site and API key settings page.'),
      },
    },
    async (input) => {
      try {
        const port = await ensureDaemon();
        return text(where(await openCanvas(port, true, input.settings ? 'settings' : ''), canvasUrl(port)));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'list_image_models',
    {
      title: 'List image sites and models',
      description:
        'List the image generation sites the user has configured, their models and the defaults. API keys are never returned. Only needed when the user asks for a specific model or site.',
      inputSchema: {},
    },
    async () => {
      try {
        const port = await ensureDaemon();
        const state = await request(port, 'state');
        const sites = state.sites.map(
          (site: { id: string; name: string; hasKey: boolean; models: string[]; defaultModel?: string }) =>
            `- ${site.name} (site id: ${site.id})${site.id === state.defaultSite ? ' [default]' : ''}${site.hasKey ? '' : ' [no API key yet]'}\n  models: ${site.models.join(', ') || 'none configured'}${site.defaultModel ? `\n  default model: ${site.defaultModel}` : ''}`,
        );
        return text(sites.length ? sites.join('\n') : 'No image sites are configured yet. Call open_canvas with settings=true.');
      } catch (error) {
        return failure(error);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
