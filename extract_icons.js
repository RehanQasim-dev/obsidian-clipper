const fs = require('fs');
const code = fs.readFileSync('/home/rehan-10xe/Documents/obsidian-clipper/excalidraw/packages/excalidraw/components/icons.tsx', 'utf-8');

const iconsToExtract = [
  'StrokeWidthBaseIcon', 'StrokeWidthBoldIcon', 'StrokeWidthExtraBoldIcon',
  'StrokeStyleSolidIcon', 'StrokeStyleDashedIcon', 'StrokeStyleDottedIcon',
  'SloppinessArchitectIcon', 'SloppinessArtistIcon', 'SloppinessCartoonistIcon',
  'EdgeSharpIcon', 'EdgeRoundIcon',
  'FillHachureIcon', 'FillCrossHatchIcon', 'FillSolidIcon',
  'FontSizeSmallIcon', 'FontSizeMediumIcon', 'FontSizeLargeIcon', 'FontSizeExtraLargeIcon',
  'FontFamilyHeadingIcon', 'FontFamilyNormalIcon', 'FontFamilyCodeIcon',
  'TextAlignLeftIcon', 'TextAlignCenterIcon', 'TextAlignRightIcon',
  'ArrowheadNoneIcon', 'ArrowheadArrowIcon', 'ArrowheadTriangleIcon', 'ArrowheadCircleIcon', 'ArrowheadBarIcon',
];

const results = [];
for (const icon of iconsToExtract) {
  const regex = new RegExp(`export const ${icon} = (?:createIcon\\(|React\\.memo\\([^{]*\\{.*?=>\\s*)\\(\\s*(<>[\\s\\S]*?</>|<svg[\\s\\S]*?</svg>|<path[\\s\\S]*?/>|<g[\\s\\S]*?</g>)`, 'g');
  const match = regex.exec(code);
  if (match) {
    results.push(`export const ${icon} = () => (\n  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ width: '100%', height: '100%' }}>\n    ${match[1].replace(/<>\s*|\s*<\/>/g, '')}\n  </svg>\n);`);
  } else {
    // Try simpler match
    const regex2 = new RegExp(`export const ${icon} = [\\s\\S]*?(<path[\\s\\S]*?/>|<g[\\s\\S]*?</g>)`);
    const match2 = regex2.exec(code);
    if (match2) {
      results.push(`export const ${icon} = () => (\n  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ width: '100%', height: '100%' }}>\n    ${match2[1]}\n  </svg>\n);`);
    } else {
      console.log(`Failed to find ${icon}`);
    }
  }
}

fs.writeFileSync('src/excalidraw-icons.tsx', 'import React from "react";\n\n' + results.join('\n\n'));
