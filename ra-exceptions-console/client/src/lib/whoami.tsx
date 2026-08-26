import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { casesApi } from './cases';

const WhoAmIContext = createContext<string>('analyst@demo');

export function WhoAmIProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState('analyst@demo');
  useEffect(() => {
    casesApi
      .whoami()
      .then((r) => setUser(r.user))
      .catch(() => {
        /* fall back to default */
      });
  }, []);
  return <WhoAmIContext.Provider value={user}>{children}</WhoAmIContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useWhoAmI = () => useContext(WhoAmIContext);
