/** Client CSS-module imports handled by the package bundler. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
