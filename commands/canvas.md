---
description: Open the canvas, or generate an image or video onto it
argument-hint: "[what to draw or animate]"
---

If the text below is empty, call the `open_canvas` tool of the hrouter-canvas MCP server and tell
me the canvas is open. Otherwise treat the text as a request: call `generate_image` with a
well-formed prompt based on it. If it asks for a video or for an image to move, then call
`generate_video` with that image's id and a prompt about the motion. If it refers to something
already on the canvas (what I selected, an earlier image or video), call `list_canvas` and
`view_canvas_item` first and build on that item instead of starting over. Tell me where each file
was saved.

$ARGUMENTS
