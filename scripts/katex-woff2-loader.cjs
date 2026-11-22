// Keep KaTeX's first-choice font for the supported browsers. Only remove fallback
// sources when all three URLs refer to the same face in the expected order.
module.exports = (css) =>
  css.replace(
    /(url\(fonts\/(KaTeX_[\w-]+)\.woff2\) format\("woff2"\)),url\(fonts\/\2\.woff\) format\("woff"\),url\(fonts\/\2\.ttf\) format\("truetype"\)/g,
    '$1'
  )
