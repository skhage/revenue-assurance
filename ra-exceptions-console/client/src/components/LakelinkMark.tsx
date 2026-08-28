// Lakelink Fiber product mark — the same abstract geometric shapes as
// client/public/favicon.svg, recolored to currentColor so it renders
// correctly on top of any token-driven background (e.g. bg-brand) in both
// light and dark mode, instead of the SVG's own hardcoded coral hex fills.
export function LakelinkMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Lakelink Fiber"
    >
      <path d="M64 64H224V224H64V64Z" fill="currentColor" opacity="0.55" />
      <path
        d="M440 448L280 448L280 352C280 316.654 308.654 288 344 288L376 288C411.346 288 440 316.654 440 352L440 448Z"
        fill="currentColor"
        opacity="0.55"
      />
      <path d="M152 288L240 448H64L152 288Z" fill="currentColor" />
      <path
        d="M280 148C280 101.608 317.608 64 364 64V64C410.392 64 448 101.608 448 148V148C448 194.392 410.392 232 364 232V232C317.608 232 280 194.392 280 148V148Z"
        fill="currentColor"
      />
    </svg>
  );
}
