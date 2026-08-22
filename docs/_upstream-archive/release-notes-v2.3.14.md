# v2.3.14

- Fixed image generation routing so agent bootstrap context cannot by itself route ordinary chat messages to the image generation model.
- Kept explicit drawing/image requests and sufficiently visual prompts routed to the configured image generation model.
