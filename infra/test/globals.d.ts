// The integration suite reads and sets a few environment variables of the process it runs in.
// Nothing this workspace loads declares `process`: the suite runs on Node, under Vitest.
declare const process: { readonly env: { [name: string]: string | undefined } };
