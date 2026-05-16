import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

// The 3D viewer pulls in Three.js and ~9.5k lines of code. Keeping the
// dashboard (Home) the only eager route makes cold start dramatically
// faster — Three.js and the viewer download on demand when a project opens.
const ProjectViewer = lazy(() => import("./pages/ProjectViewer"));
const Bitacora = lazy(() => import("./pages/Bitacora"));
const RFIPage = lazy(() => import("./pages/RFI"));
const Report = lazy(() => import("./pages/Report"));
const UTMCalibration = lazy(() => import("./pages/UTMCalibration"));

function RouteFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-white">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-teal-500" />
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/project/:id" component={ProjectViewer} />
        <Route path="/project/:id/bitacora" component={Bitacora} />
        <Route path="/project/:id/rfi" component={RFIPage} />
        <Route path="/project/:id/report" component={Report} />
        <Route path="/project/:id/utm" component={UTMCalibration} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
