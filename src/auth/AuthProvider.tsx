import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { AuthError, Session, User } from '@supabase/supabase-js'
import {
  isSupabaseConfigured,
  supabase,
  supabaseConfigurationError,
} from '@/lib/supabase'

export interface AuthActionResult {
  error: string | null
}

export interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
  authError: string | null
  configurationError: string | null
  signIn: (email: string, password: string) => Promise<AuthActionResult>
  requestAccess: (fullName: string, email: string, password: string) => Promise<AuthActionResult>
  signOut: () => Promise<AuthActionResult>
  clearAuthError: () => void
  /** Manda o e-mail com o link para criar uma senha nova. */
  sendPasswordReset: (email: string) => Promise<AuthActionResult>
  /** Verdadeiro enquanto a pessoa esta voltando pelo link de redefinicao. */
  recovering: boolean
  /** Grava a senha nova e encerra a recuperacao. */
  updatePassword: (password: string) => Promise<AuthActionResult>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function friendlyAuthError(error: AuthError): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'E-mail ou senha incorretos.'
    case 'email_not_confirmed':
      return 'Este e-mail ainda não foi confirmado.'
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.'
    case 'user_banned':
      return 'Este acesso está temporariamente indisponível. Fale com o administrador.'
    default:
      return error.message || 'Não foi possível autenticar. Tente novamente.'
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const [authError, setAuthError] = useState<string | null>(null)
  // Volta pelo link de "esqueci a senha". O Supabase abre uma sessao
  // temporaria e avisa com o evento PASSWORD_RECOVERY; enquanto isso for
  // verdadeiro, a unica tela e a de criar a senha nova.
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    if (!isSupabaseConfigured) return

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setLoading(false)
      if (nextSession) setAuthError(null)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  const clearAuthError = useCallback(() => setAuthError(null), [])

  const signIn = useCallback(async (email: string, password: string): Promise<AuthActionResult> => {
    if (!isSupabaseConfigured) {
      const message = supabaseConfigurationError ?? 'O Supabase não está configurado.'
      setAuthError(message)
      return { error: message }
    }

    setAuthError(null)
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (error) {
      const message = friendlyAuthError(error)
      setAuthError(message)
      return { error: message }
    }

    if (data.session) setSession(data.session)
    return { error: null }
  }, [])

  const requestAccess = useCallback(
    async (fullName: string, email: string, password: string): Promise<AuthActionResult> => {
      if (!isSupabaseConfigured) {
        const message = supabaseConfigurationError ?? 'O Supabase não está configurado.'
        setAuthError(message)
        return { error: message }
      }

      setAuthError(null)
      const { error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: { full_name: fullName.trim() },
          emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
        },
      })

      if (error) {
        const message = friendlyAuthError(error)
        setAuthError(message)
        return { error: message }
      }

      // A solicitação só será liberada no painel do administrador. Mantemos a
      // tela de login em vez de levar um acesso ainda pendente ao sistema.
      await supabase.auth.signOut({ scope: 'local' })
      setSession(null)
      return { error: null }
    },
    [],
  )

  const signOut = useCallback(async (): Promise<AuthActionResult> => {
    if (!isSupabaseConfigured) {
      const message = supabaseConfigurationError ?? 'O Supabase não está configurado.'
      setAuthError(message)
      return { error: message }
    }

    setAuthError(null)
    const { error } = await supabase.auth.signOut({ scope: 'local' })

    if (error) {
      const message = friendlyAuthError(error)
      setAuthError(message)
      return { error: message }
    }

    setSession(null)
    return { error: null }
  }, [])

  const sendPasswordReset = useCallback(async (email: string): Promise<AuthActionResult> => {
    if (!isSupabaseConfigured) {
      const message = supabaseConfigurationError ?? 'O Supabase não está configurado.'
      setAuthError(message)
      return { error: message }
    }
    setAuthError(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
    })
    if (error) {
      const message = friendlyAuthError(error)
      setAuthError(message)
      return { error: message }
    }
    return { error: null }
  }, [])

  const updatePassword = useCallback(async (password: string): Promise<AuthActionResult> => {
    setAuthError(null)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      const message = friendlyAuthError(error)
      setAuthError(message)
      return { error: message }
    }
    setRecovering(false)
    return { error: null }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      authError,
      configurationError: supabaseConfigurationError,
      signIn,
      requestAccess,
      signOut,
      clearAuthError,
      sendPasswordReset,
      recovering,
      updatePassword,
    }),
    [authError, clearAuthError, loading, requestAccess, session, signIn, signOut, sendPasswordReset, recovering, updatePassword],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// O provider e seu hook formam uma única API pública de autenticação.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth precisa ser usado dentro de <AuthProvider>.')
  return context
}

