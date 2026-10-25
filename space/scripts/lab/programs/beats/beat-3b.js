// Replaces beat 3 while it waits in the queue (scene_control replace): the cut goes down instead of up.
const { h } = stage
say("Or move the cut down [[down]] and the disc grows back to the full width.")
await mark("down")
await tween(h, 10, 1.4)
