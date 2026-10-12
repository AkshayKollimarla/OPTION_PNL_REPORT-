"use client";

import OptionsAnalysisView from "../../../components/OptionsAnalysisView";

// The whole book over a date range: bot performance by account, and options
// PNL by token with the strategies behind each coin.
export default function OptionsSummaryPage() {
  return <OptionsAnalysisView view="cumulative" />;
}
