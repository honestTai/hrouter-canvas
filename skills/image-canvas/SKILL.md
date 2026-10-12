---
name: image-canvas
description: Generate or edit images and show them on the user's infinite canvas. Use when the user asks to draw, generate, design or modify an image (画图、生图、出图、海报、图标、logo、插画、配图、改图) and you cannot produce images natively, or when they mention the canvas (画布).
---

# Image canvas

You have the `hrouter-canvas` MCP server. It turns a prompt into a real image file and puts it on
an infinite canvas that opens in the user's browser.

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

## Rules

- Generation may cost the user money and take up to a few minutes. Never retry a failed or
  finished generation on your own; report the error and let the user decide.
- Image sites and API keys are set only by the user on the canvas settings page. If the tool says
  no site is configured, it has already opened that page: ask the user to fill it in, then try
  again. Never ask for an API key in chat and never write one to a file.
- In a remote or headless session the canvas cannot open. The files are still saved; give the
  user the paths.
