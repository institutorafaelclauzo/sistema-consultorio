import logo from '@/assets/logo-clauzo.png'

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${light ? 'text-white' : 'text-[#081b2c]'}`} aria-label="Instituto Clauzo, Central de Cuidado">
      <img src={logo} alt="" className="h-12 w-12 shrink-0 object-contain" />
      <div className="min-w-0">
        <p className="text-[12px] font-bold tracking-[0.12em]">INSTITUTO CLAUZO</p>
        <p className={`mt-1 text-[9px] font-medium tracking-[0.14em] ${light ? 'text-[#dcc28b]' : 'text-[#827044]'}`}>CENTRAL DE CUIDADO</p>
      </div>
    </div>
  )
}
