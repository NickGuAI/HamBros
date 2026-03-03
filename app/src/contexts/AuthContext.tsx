import { createContext, useContext, type ReactNode } from 'react'

interface AuthContextValue {
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  signOut,
  children,
}: {
  signOut: () => void
  children: ReactNode
}) {
  return (
    <AuthContext.Provider value={{ signOut }}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  return ctx
}
