/*
 * Exports:
 * - SerializableJson: recursive JSON value accepted by transcript normalisers.
 */
export type SerializableJson =
  | null
  | boolean
  | number
  | string
  | SerializableJson[]
  | { [key: string]: SerializableJson };
