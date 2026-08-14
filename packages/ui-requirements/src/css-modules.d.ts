declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

// Side-effect stylesheet imports (e.g. a component library's dist css);
// inlined as a <style data-plugin> tag by the shared tsdown preset.
declare module '*.css'
