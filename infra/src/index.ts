/** Placeholder until M2: the names of the deployment stages. */
export const stages = ["staging", "production"] as const;
export type Stage = (typeof stages)[number];

export const isStage = (value: string): value is Stage => stages.some((stage) => stage === value);
