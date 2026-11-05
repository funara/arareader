/** ARAPdf file badge shared by the tab strip and the home recents list */
export function PdfGlyph({ size = 16 }: { size?: number }) {
  return (
    <img
      src="./ARAPdf-icon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block', flexShrink: 0 }}
    />
  )
}
