import { Suspense } from "react";
import { AskView } from "./ask-view";

// AskView reads the query string (the deep link), which is only known in the browser
export default function Page() {
  return <Suspense><AskView /></Suspense>;
}
