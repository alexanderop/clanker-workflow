import { Text } from "ink";
import { SPINNER_FRAMES } from "./format.js";

export interface SpinnerProps {
  readonly frame: number;
}

export function Spinner({ frame }: SpinnerProps) {
  return <Text>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]}</Text>;
}
