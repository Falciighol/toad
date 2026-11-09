import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DurationInput, inferDurationUnit } from "../ui";

function Harness({ initial, units }: { initial: number; units?: ("s" | "min" | "h")[] }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <DurationInput aria-label="Duration" value={v} units={units} onChange={(x) => setV(x ?? 0)} />
      <output data-testid="secs">{v}</output>
    </>
  );
}

describe("DurationInput", () => {
  it("picks the largest unit that holds the value", () => {
    expect(inferDurationUnit(7200)).toBe("h");
    expect(inferDurationUnit(120)).toBe("min");
    expect(inferDurationUnit(90)).toBe("s");
    expect(inferDurationUnit(0)).toBe("s");
    expect(inferDurationUnit(7200, ["s", "min"])).toBe("min");
  });
  it("shows and stores in the chosen unit", () => {
    render(<Harness initial={30} />);
    const input = screen.getByLabelText("Duration") as HTMLInputElement;
    const unit = screen.getByLabelText("Duration unit") as HTMLSelectElement;
    expect(input.value).toBe("30");
    expect(unit.value).toBe("s");
    // Picking a unit keeps the typed number: 30 s → 30 min.
    fireEvent.change(unit, { target: { value: "min" } });
    expect(screen.getByTestId("secs").textContent).toBe("1800");
    expect(input.value).toBe("30");
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(screen.getByTestId("secs").textContent).toBe("90");
    fireEvent.blur(input);
    expect(input.value).toBe("1.5");
    expect(unit.value).toBe("min");
  });
  it("opens a stored value in its natural unit", () => {
    render(<Harness initial={7200} />);
    expect((screen.getByLabelText("Duration") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Duration unit") as HTMLSelectElement).value).toBe("h");
  });
});
