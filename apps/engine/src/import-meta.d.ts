// `import.meta.url` is how a Worker names its own entry module to Alchemy, and how a path is
// anchored to the file that declares it. No type package this workspace loads declares it.
interface ImportMeta {
  url: string;
}
