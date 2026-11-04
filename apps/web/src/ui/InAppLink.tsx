import { createContext, useContext, type AnchorHTMLAttributes } from 'react';
import { locationToSearch, type Location } from '../app/navigation';

/** canvas-4e0: how a link moves within the app -- App's navigate() (history, focus, the unsaved-changes
 *  check) and the address for a location. */
export interface InAppNavigation {
  navigate: (to: Location) => void;
  hrefFor: (to: Location) => string;
}

export const InAppNavigationContext = createContext<InAppNavigation | null>(null);

/** A plain link to a location, never a page load:
 *  a plain click navigates in the app; a modified one (new tab or window) is left to the browser. Outside
 *  App (a page rendered on its own in a test) it is an ordinary link to the same address. */
export function InAppLink({ to, onClick, ...props }: { to: Location } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const navigation = useContext(InAppNavigationContext);
  const href = navigation ? navigation.hrefFor(to) : locationToSearch(to);
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (!navigation || event.defaultPrevented) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigation.navigate(to);
      }}
    />
  );
}
