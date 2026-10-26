---
name: image-canvas
description: Generate or edit images and videos and show them on the user's infinite canvas. Use when the user asks to draw, generate, design or modify an image (画图、生图、出图、海报、图标、logo、插画、配图、改图), to make a video or animate an image (生成视频、做视频、图生视频、让图动起来), and you cannot produce them natively, or when they mention the canvas (画布).
---

# Image canvas

You have the `hrouter-canvas` MCP server. It turns a prompt into a real image or MP4 file and puts
it on an infinite canvas that opens in the user's browser.

## When to use it

- The user wants a picture and you have no built-in image generation. This is the default path.
- The user asks to change an existing image file ("make the background blue", "换个风格").
- The user mentions the canvas, or wants to see, compare or arrange generated images.

If you do have native image generation, prefer it unless the user asks for the canvas.

## How

1. Call `generate_image` once per request.
   - `prompt`: write it in the user's language. Be concrete about subject, style, composition,
     lighting and any text that must appear. Do not pad it with quality buzzwords.
   - `aspect_ratio`: set it when the use is clear (app icon `1:1`, banner `16:9`, phone wallpaper
     `9:16`). Otherwise leave it out.
   - `reference_images`: absolute paths of files to edit or imitate, or image ids from an earlier
     result when iterating on it.
   - `save_to`: when the image belongs in the project, pass the absolute target directory or file
     path so a copy is written there. Nothing is ever overwritten.
   - `count`: only when the user wants options.
2. Tell the user the saved path and that it is on the canvas. Do not read the file back just to
   describe it unless they ask.
3. To refine, call `generate_image` again with the previous image id in `reference_images`.

Leave `model` and `site` out unless the user names one; `list_image_models` shows what exists.

## Video

Image-to-video is two calls, and you drive both:

1. Get the still: call `generate_image`, or use an existing image the user points to.
2. Call `generate_video` with `image` set to that image's id (or its absolute path) and a
   `prompt` about motion: what moves, how the camera moves, pacing and mood. Do not re-describe
   everything that is already in the picture.

The still and the video may come from different sites and models; the user's defaults already
route each one to the right place, so leave `site` and `model` out. Without `image` it is
text-to-video, and `aspect_ratio` applies.

- `duration`: seconds. Set it only when the user gives a length (HRouter grok models: 1–15,
  default 8). Longer videos cost more.
- `resolution`: such as `480p` or `720p`, only when asked.
- `save_to`: the absolute directory or `.mp4` path when the video belongs in the project.

A video usually takes 1–5 minutes. If the call is interrupted or times out, the job keeps
running: call `video_status` (with the job id if you have it) instead of calling
`generate_video` again. A finished video comes back with a 2×2 sheet of keyframes so you can see
what was made.

## Working with what is already on the canvas

The user also works on the canvas directly: they select, arrange, capture frames and generate
there. When they refer to something that already exists ("我选中的那个", "刚才那个视频",
"the second poster"), look before you act:

1. `list_canvas` lists every image and video on the board they have open, newest last, with ids,
   prompts, models, file paths, what each was made from, and `[SELECTED]` on what they selected.
2. `view_canvas_item` shows you one item: an image as itself, a video as four keyframes.
3. Then build on it:
   - Change an image: `generate_image` with its id in `reference_images`.
   - Animate an image: `generate_video` with its id as `image`.
   - Continue a video: `generate_video` with the video id as `image` (starts from its last frame).
   - Change a moment of a video: `extract_frame` (`first`, `last` or seconds), then edit that
     frame with `generate_image`, and animate the result again if they want.

Everything you make is linked on the canvas to what it came from, so the user can follow it.

## Rules

- Generation may cost the user money and take up to a few minutes. Never retry a failed or
  finished generation on your own; report the error and let the user decide. Videos are billed
  per second, so this matters even more for them.
- Image sites and API keys are set only by the user on the canvas settings page. If the tool says
  no site is configured, it has already opened that page: ask the user to fill it in, then try
  again. Never ask for an API key in chat and never write one to a file.
- In a remote or headless session the canvas cannot open. The files are still saved; give the
  user the paths.
