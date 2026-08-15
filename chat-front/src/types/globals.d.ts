declare module "@emoji-mart/react" {
  import type { ComponentType } from "react";
  const Picker: ComponentType<Record<string, unknown>>;
  export default Picker;
}

declare module "@emoji-mart/data" {
  const data: Record<string, unknown>;
  export default data;
}
