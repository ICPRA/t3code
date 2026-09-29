import { act } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { PanelSeparator } from "../../../../../../project-workbench/extensions/workbench-ui/src/PanelSeparator";

it("resizes both panel edges, clamps widths, and stops on cancelled pointer capture", () => {
  for (const direction of [1, -1] as const) {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<PanelSeparator label="Resize" width={224} min={190} max={320} direction={direction} onChange={onChange} />);
    });
    const separator = renderer.root.findByProps({ role: "separator" });
    const preventDefault = vi.fn();
    separator.props.onKeyDown({ key: "ArrowRight", preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(224 + 10 * direction);
    separator.props.onKeyDown({ key: "Home", preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(190);
    const currentTarget = { focus: vi.fn(), setPointerCapture: vi.fn() };
    separator.props.onPointerDown({ button: 0, pointerId: 1, clientX: 100, preventDefault, currentTarget });
    separator.props.onPointerMove({ clientX: 100 + 1000 * direction });
    expect(onChange).toHaveBeenLastCalledWith(320);
    separator.props.onPointerMove({ clientX: 100 - 1000 * direction });
    expect(onChange).toHaveBeenLastCalledWith(190);
    separator.props.onLostPointerCapture();
    onChange.mockClear();
    separator.props.onPointerMove({ clientX: 140 });
    expect(onChange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  }
});
