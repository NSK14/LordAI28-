/** Extensible, deterministic routing before a message enters the chat gateway. */
const IMAGE_PATTERNS = [
  /\b(draw|paint|sketch|render|illustrate|visualize)\b/i,
  /^(?:generate|create|make)\b/i,
  /\b(generate|create|make)\b(?:\s+(?:an?\s+)?)?(?:image|picture|visual|artwork|logo|icon|poster|wallpaper|avatar|thumbnail|illustration|scene|variations?)\b/i,
  /\b(generate|create|make)\s+(?:four|[2-6])\s+variations?\b/i,
  /\b(make|turn|transform|convert|restyle)\s+(?:this|the|an?\s+image|it)\b/i,
  /\b(remove|replace|change|erase|edit|extend|expand|upscale|enhance|recolor)\b.{0,80}\b(background|object|person|image|style|resolution|quality|canvas)\b/i,
  /\b(remove the background|background removal|transparent background|outpaint|inpaint|image variation|image variations)\b/i,
  /\b(logo|icon pack|wallpaper|book cover|anime|concept art|pixel art|comic|cinematic|portrait|ui mockup|infographic|avatar|thumbnail)\b/i,
];

const CHAT_GUARDS = [/\b(explain|describe|history of|what is|how does|why does)\b/i];

export function detectImageIntent(text: string): boolean {
  const normalized = text.trim();
  return (
    !CHAT_GUARDS.some((pattern) => pattern.test(normalized)) &&
    IMAGE_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
