I found two real bugs in this change, both in `src/gpu/vulkan/SDL_gpu_vulkan.c`:

1. **Line 10533 — cleanup now only runs when a frame is presented.** The new code skips the cleanup block unless the command buffer presents: fence polling, cleaning finished command buffers, freeing empty memory allocations, and destroying released resources. Before, this ran on every submit.
   - **Who is affected:** headless, compute-only or offscreen apps that never present and never call `SDL_WaitForGPUIdle`.
   - **What happens:** finished command buffers and fences are never recycled. Released buffers and textures are never destroyed, and empty allocations are never freed. The submitted-buffer list, the command pools and GPU memory grow without limit.

2. **Line 5881 — possible crash in `VULKAN_INTERNAL_CycleActiveTexture`.** The new layout transition runs on the texture before the `if (!texture) return;` check.
   - **What happens:** if texture creation fails (for example, out of memory), `CreateTexture` returns NULL and the transition reads that texture's subresources through a NULL pointer. It crashes instead of returning cleanly.
   - **Fix:** move the transition below the NULL check.
