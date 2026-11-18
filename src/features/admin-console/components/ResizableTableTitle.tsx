"use client";

import type { HTMLAttributes, SyntheticEvent } from "react";
import { Resizable, type ResizeCallbackData } from "react-resizable";

type Props = Readonly<
  HTMLAttributes<HTMLTableCellElement> & {
    width?: number;
    onResize?: (event: SyntheticEvent, data: ResizeCallbackData) => void;
  }
>;

export function ResizableTableTitle({ onResize, width, ...restProps }: Props) {
  if (!width || !onResize) {
    return <th {...restProps} />;
  }

  return (
    <Resizable
      width={width}
      height={0}
      resizeHandles={["e"]}
      handle={
        <span
          className="admin-table-resize-handle"
          onClick={(event) => {
            event.stopPropagation();
          }}
        />
      }
      onResize={onResize}
      draggableOpts={{ enableUserSelectHack: false }}
    >
      <th {...restProps} />
    </Resizable>
  );
}
