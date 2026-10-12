"use client";

import OptionsAnalysisView from "../../../components/OptionsAnalysisView";

// One strategy at a time: its legs, its bot half, its combined result.
// The book-wide view lives at /options/summary and shares this component.
export default function StrategyAnalysisPage() {
  return <OptionsAnalysisView view="analysis" />;
}
