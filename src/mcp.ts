import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canvasUrl, ensureDaemon, openCanvas, request, type OpenResult } from './client.ts';
import { applyEnvSite, HttpError, VERSION } from './config.ts';
import { ffmpegPath } from './frames.ts';
import type { VideoJob } from './daemon.ts';

const INSTRUCTIONS = `HRouter Canvas gives you image and video generation plus an infinite canvas the user can see.
Use generate_image whenever the user asks you to draw, generate, create, design or edit an image
(画图、生图、出图、做海报、图标、logo、插画、配图、改图、P 图) and you have no native image
generation ability of your own, or whenever the user mentions the canvas (画布).
Use generate_video when the user wants a video or animation (生成视频、做视频、动起来、图生视频).
For image-to-video, first make or pick the still with generate_image, then pass its image id to
generate_video as \`image\`. Image sites and video sites are configured separately, each with its
own key and default, so leave site and model out unless the user names one.
Results are saved as real files and appear on the canvas, which opens in the user's browser.
To work with what is already there ("改一下我选中的那张", "根据刚才那个视频再做一个"), call
list_canvas: it lists every image and video with ids, prompts, what each was made from and what the
user has selected. view_canvas_item lets you look at one (a video shows as four keyframes).
extract_frame turns a moment of a video into an image you can edit with generate_image; passing
a video id as generate_video's image continues that video from its last frame.
Sites and API keys are configured only by the user, on the canvas settings page. Never ask
the user to paste an API key into the chat, and never try to set one yourself.`;

const where = (open: OpenResult, url: string) =>
  open === 'opened'
    ? `Canvas opened in the user's browser: ${url}`
    : open === 'already-open'
      ? `Canvas is already open in the user's browser and now shows the result: ${url}`
      : open === 'headless'
        ? `No browser here (remote or headless session). The canvas is at ${url} on this machine; the user can run \`npx hrouter-canvas-mcp url\` for a link that includes access.`
        : `Could not launch a browser. The user can run \`npx hrouter-canvas-mcp open\`.`;
type Picture = { mime: string; data: string };
const image = (picture?: Picture) =>
  picture ? [{ type: 'image' as const, data: picture.data, mimeType: picture.mime }] : [];
const withPicture = (value: string, picture?: Picture) => ({
  content: [{ type: 'text' as const, text: value }, ...image(picture)],
});
const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

async function failure(error: unknown, port?: number, what = 'Image generation') {
  const message = error instanceof Error ? error.message : String(error);
  // 409 means the user has setup to do; take them to the settings page instead of failing blind.
  if (error instanceof HttpError && error.status === 409 && port) {
    const open = await openCanvas(port, true, 'settings');
    return text(
      `${message}\n\nThe user must add a site, API key and model on the canvas settings page (never in chat). ${where(open, canvasUrl(port))}\nAsk them to finish that, then call this tool again.`,
      true,
    );
  }
  return text(`${what} failed: ${message}`, true);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (job: VideoJob) =>
  Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
function describe(job: VideoJob): string {
  if (job.status === 'done' && job.video) {
    const v = job.video;
    return [
      `Video ready (job ${job.id}, ${job.model} via ${job.site}, ${seconds(job)}s):`,
      `- ${v.savedTo || v.path} (${v.width}×${v.height}${v.duration ? `, ${v.duration}s` : ''}, id ${v.id})` +
        (v.savedTo ? `\n  canvas copy: ${v.path}` : ''),
    ].join('\n');
  }
  if (job.status === 'failed') return `Video job ${job.id} failed: ${job.error}`;
  return `Video job ${job.id} is still generating (${job.model} via ${job.site}, ${seconds(job)}s so far).`;
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
          .describe('Absolute file paths, or image ids from a previous result or list_canvas, to edit or use as visual reference. For a video, call extract_frame first and pass the frame id.'),
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
    'generate_video',
    {
      title: 'Generate a video',
      description:
        'Generate a short video from a text prompt, optionally starting from an image (image-to-video). For image-to-video, pass an image id from generate_image (or an absolute image path) as `image`; the image may have been made by a different site or model. The prompt should describe motion, camera movement and pacing rather than re-describing the still. The result is an MP4 saved to disk and shown on the canvas next to its source image. Videos usually take 1-5 minutes and are billed per second, so never call this again for the same request unless the user asks. If the call is interrupted, the job keeps running: use video_status to find the result.',
      inputSchema: {
        prompt: z.string().min(1).max(8000).describe('What happens in the video: motion, camera, mood.'),
        image: z
          .string()
          .optional()
          .describe('First frame: an image id (from generate_image, extract_frame or list_canvas) or an absolute PNG/JPEG/WebP path. A video id continues that video from its last frame.'),
        duration: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Length in seconds. HRouter grok models accept 1-15 (default 8). Omit unless the user asks.'),
        resolution: z
          .string()
          .regex(/^\d{3,4}p$/)
          .optional()
          .describe('For example 480p or 720p. HRouter defaults to 480p. Omit unless the user asks.'),
        aspect_ratio: z
          .string()
          .regex(/^\d{1,4}:\d{1,4}$/)
          .optional()
          .describe('Only for text-to-video; with an image the video follows the image.'),
        save_to: z
          .string()
          .optional()
          .describe('Absolute directory or .mp4 path to also copy the result into. Existing files are never overwritten.'),
        model: z.string().optional().describe('Video model id from list_image_models. Omit to use the user\'s default.'),
        site: z.string().optional().describe('Video site id or name from list_image_models (video sites are separate from image sites). Omit to use the user\'s default video site.'),
      },
    },
    async (input, extra) => {
      let port: number | undefined;
      try {
        port = await ensureDaemon();
        const opening = openCanvas(port);
        let job = await request<VideoJob>(port, 'videos', {
          body: {
            prompt: input.prompt,
            image: input.image,
            duration: input.duration,
            resolution: input.resolution,
            aspectRatio: input.aspect_ratio,
            saveTo: input.save_to,
            model: input.model,
            site: input.site,
          },
        });
        const every = Math.min(2000, Number(process.env.HROUTER_CANVAS_VIDEO_POLL_MS) || 2000);
        const token = extra._meta?.progressToken;
        for (let tick = 1; job.status === 'running' && !extra.signal.aborted; tick++) {
          await sleep(every);
          job = await request<VideoJob>(port, `videos/${job.id}`);
          // Progress keeps clients that honour it from timing out a long but healthy call.
          if (token !== undefined)
            await extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: tick, message: `生成视频中，已用 ${seconds(job)} 秒` },
              })
              .catch(() => {});
        }
        const shown = where(await opening, canvasUrl(port));
        if (job.status === 'failed')
          return text(`${describe(job)}\nDo not retry on your own; tell the user and let them decide.`, true);
        if (job.status === 'running')
          return text(`${describe(job)}\nIt will appear on the canvas when done. Call video_status with job_id ${job.id} later.\n${shown}`);
        // Keyframes let you check the result and talk about it, since you cannot play the video.
        const look = await request<{ picture?: Picture; note: string }>(port, `items/${job.video!.id}/view`).catch(
          (error: Error) => ({ picture: undefined, note: `Keyframes unavailable: ${error.message}` }),
        );
        return withPicture(
          `${describe(job)}\n${shown}\n${look.picture ? `Attached: ${look.note}.` : look.note}\nTell the user where the file is. Do not re-generate unless asked.`,
          look.picture,
        );
      } catch (error) {
        return failure(error, port, 'Video generation');
      }
    },
  );

  server.registerTool(
    'video_status',
    {
      title: 'Check video jobs',
      description:
        'Check a video job started by generate_video, or list recent video jobs when no job_id is given. Use it when a generate_video call was interrupted or timed out. Reading status never starts or repeats a generation.',
      inputSchema: {
        job_id: z.string().regex(/^v[a-f0-9]{12}$/).optional().describe('The job id generate_video reported.'),
      },
    },
    async (input) => {
      try {
        const port = await ensureDaemon();
        if (input.job_id) return text(describe(await request<VideoJob>(port, `videos/${input.job_id}`)));
        const { jobs } = await request<{ jobs: VideoJob[] }>(port, 'videos');
        return text(jobs.length ? jobs.slice(0, 10).map(describe).join('\n') : 'No video jobs since the canvas service started.');
      } catch (error) {
        return failure(error, undefined, 'Video status');
      }
    },
  );

  server.registerTool(
    'list_canvas',
    {
      title: 'List what is on the canvas',
      description:
        'List the images and videos on the user\'s canvas (the current board unless one is given): ids, type, size, prompt, model, file path, what each was made from, and which items the user has selected. Use it when the user refers to something already on the canvas ("the one I selected", "the last video", "那张图"), before editing or animating it.',
      inputSchema: {
        board: z.string().regex(/^[a-f0-9]{16}$/).optional().describe('Board id. Omit for the board the user has open.'),
        limit: z.number().int().min(1).max(200).optional().describe('How many of the newest items to list. Default 30.'),
      },
    },
    async (input) => {
      try {
        const port = await ensureDaemon();
        const params = new URLSearchParams({
          ...(input.board ? { board: input.board } : {}),
          ...(input.limit ? { limit: String(input.limit) } : {}),
        });
        const canvas = await request<{
          board: { id: string; title: string; count: number };
          boards: Array<{ id: string; title: string; count: number }>;
          selected: string[];
          pending: Array<{ prompt: string; model: string; kind: string }>;
          items: Array<{
            id: string;
            type: string;
            path: string;
            width: number;
            height: number;
            duration?: number;
            prompt: string;
            model: string;
            site: string;
            frame?: { of: string; at: string };
            from: string[];
          }>;
        }>(port, `canvas?${params}`);
        const selected = new Set(canvas.selected);
        const lines = canvas.items.map((item) => {
          const what = item.frame
            ? `frame (${item.frame.at}) of video ${item.frame.of}`
            : item.type === 'import'
              ? 'imported image'
              : `${item.type}${item.model ? ` by ${item.model}${item.site ? ` via ${item.site}` : ''}` : ''}`;
          return (
            `- ${item.id}${selected.has(item.id) ? ' [SELECTED]' : ''}: ${what}, ${item.width}×${item.height}${item.duration ? `, ${item.duration}s` : ''}` +
            (item.prompt && !item.frame ? `\n  prompt: ${item.prompt.replace(/\s+/g, ' ').slice(0, 160)}` : '') +
            (item.from.length ? `\n  made from: ${item.from.join(', ')}` : '') +
            `\n  file: ${item.path}`
          );
        });
        const others = canvas.boards.filter((b) => b.id !== canvas.board.id);
        return text(
          [
            `Board "${canvas.board.title}" (id ${canvas.board.id}), ${canvas.board.count} item(s)${canvas.items.length < canvas.board.count ? `, newest ${canvas.items.length} shown` : ''}, oldest first:`,
            ...(lines.length ? lines : ['- (empty)']),
            canvas.selected.length
              ? `The user has selected: ${canvas.selected.join(', ')}.`
              : 'Nothing is selected on the canvas.',
            ...(canvas.pending.length
              ? [`Still generating: ${canvas.pending.map((p) => `${p.kind} with ${p.model}`).join(', ')}.`]
              : []),
            ...(others.length
              ? [`Other boards: ${others.map((b) => `"${b.title}" (id ${b.id}, ${b.count})`).join(', ')}.`]
              : []),
            'Use view_canvas_item to look at an item before changing it.',
          ].join('\n'),
        );
      } catch (error) {
        return failure(error, undefined, 'Listing the canvas');
      }
    },
  );

  server.registerTool(
    'view_canvas_item',
    {
      title: 'Look at an image or video on the canvas',
      description:
        'Return a picture of one canvas item so you can see it: an image as itself, a video as a 2×2 sheet of keyframes at 0, ¼, ½ and ¾ of its length. Use it to understand what the user wants changed, or to check a result.',
      inputSchema: {
        id: z.string().regex(/^[a-f0-9]{16}$/).describe('Item id from list_canvas or an earlier result.'),
      },
    },
    async (input) => {
      let port: number | undefined;
      try {
        port = await ensureDaemon();
        // Without ffmpeg, video frames are decoded by the canvas page, so it must be open.
        if (!ffmpegPath()) await openCanvas(port);
        const look = await request<{
          item: { id: string; mime: string; width: number; height: number; duration?: number; prompt: string; model: string; path: string };
          picture?: Picture;
          note: string;
        }>(port, `items/${input.id}/view`);
        const { item } = look;
        return withPicture(
          [
            `${item.mime.startsWith('video/') ? 'Video' : 'Image'} ${item.id}: ${item.width}×${item.height}${item.duration ? `, ${item.duration}s` : ''}${item.model ? `, ${item.model}` : ''}`,
            ...(item.prompt ? [`prompt: ${item.prompt}`] : []),
            `file: ${item.path}`,
            ...(look.note ? [look.note] : []),
          ].join('\n'),
          look.picture,
        );
      } catch (error) {
        return failure(error, port, 'Viewing the item');
      }
    },
  );

  server.registerTool(
    'extract_frame',
    {
      title: 'Take a frame from a video',
      description:
        'Save one frame of a canvas video as a new image on the canvas, linked from the video. Use it to edit a moment of a video with generate_image (pass the returned id in reference_images), or to start a new video from it with generate_video. To simply continue a video, you can pass the video id to generate_video instead. Costs nothing.',
      inputSchema: {
        video_id: z.string().regex(/^[a-f0-9]{16}$/).describe('Video id from list_canvas or generate_video.'),
        at: z
          .union([z.enum(['first', 'last']), z.number().min(0).max(3600)])
          .optional()
          .describe('"first", "last" (default) or a time in seconds.'),
      },
    },
    async (input) => {
      let port: number | undefined;
      try {
        port = await ensureDaemon();
        await openCanvas(port);
        const frame = await request<{
          id: string;
          path: string;
          width: number;
          height: number;
          label: string;
          picture: Picture;
        }>(port, `items/${input.video_id}/frame`, { body: { at: input.at ?? 'last' } });
        return withPicture(
          `Saved the ${frame.label} of video ${input.video_id} as image ${frame.id} (${frame.width}×${frame.height}):\n- ${frame.path}\nUse ${frame.id} in generate_image reference_images to edit it, or as generate_video image to animate it.`,
          frame.picture,
        );
      } catch (error) {
        return failure(error, port, 'Extracting the frame');
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
      title: 'List image and video sites and models',
      description:
        'List the sites the user has configured, their image and video models and the defaults. API keys are never returned. Only needed when the user asks for a specific model or site.',
      inputSchema: {},
    },
    async () => {
      try {
        const port = await ensureDaemon();
        const state = await request(port, 'state');
        type Listed = { id: string; name: string; hasKey: boolean; models: string[]; defaultModel?: string };
        const describeSite = (site: Listed, fallback: string | null) =>
          `- ${site.name} (site id: ${site.id})${site.id === fallback ? ' [default]' : ''}${site.hasKey ? '' : ' [no API key yet]'}\n  models: ${site.models.join(', ') || 'none configured'}${site.defaultModel ? `\n  default model: ${site.defaultModel}` : ''}`;
        const sites = [
          'Image sites (for generate_image):',
          ...(state.sites.length
            ? state.sites.map((site: Listed) => describeSite(site, state.defaultSite))
            : ['- none configured']),
          'Video sites (for generate_video; separate sites and keys from images):',
          ...(state.videoSites.length
            ? state.videoSites.map((site: Listed) => describeSite(site, state.defaultVideoSite))
            : ['- none configured']),
        ];
        return text(sites.join('\n'));
      } catch (error) {
        return failure(error);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
