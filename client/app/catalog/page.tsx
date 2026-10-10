import { Suspense } from "react";
import { CatalogView } from "./catalog-view";

// CatalogView reads the query string (?table=<schema.name> opens one table), which is only known in the browser
export default function Page() {
  return <Suspense><CatalogView /></Suspense>;
}
