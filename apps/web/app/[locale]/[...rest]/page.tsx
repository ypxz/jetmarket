import { notFound } from "next/navigation";

// Catch-all for unmatched locale paths → localized not-found UI with chrome.
export default function CatchAllPage() {
  notFound();
}
