// The one form of Vite's `import.meta.glob` this package uses. `vite/client` does not resolve
// here (Vite is not a direct dependency) and `vitest/importMeta` does not declare `glob`
// (M1 Part A findings). Any other form of the call is a type error.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { readonly eager: true; readonly import: "default" },
  ): Record<string, T>;
}
