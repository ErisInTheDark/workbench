/*
 * Exports:
 * - InstructionInjectionTemplate/injectionTemplate: keyed instruction template contract and constructor. Keywords: prompt, injection, template.
 */

export interface InstructionInjectionTemplate {
  readonly [id: string]: {
    readonly description: string;
    readonly injection: string;
  };
}

export function injectionTemplate(
  id: string,
  description: string,
  injection: string,
): InstructionInjectionTemplate {
  return {
    [id]: {
      description,
      injection: injection.trim(),
    },
  };
}

