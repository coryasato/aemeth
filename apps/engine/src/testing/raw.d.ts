// A file a test reads as text, through Vite's `?raw` import: the sample database's seed.
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
