import Image from "next/image";

export const Logo = () => (
    <div className="flex items-center gap-3 font-bold text-lg tracking-tight text-white select-none cursor-pointer">
        <div className="relative h-10 w-10 overflow-hidden rounded-full border border-white/10 bg-black/20 shadow-[0_0_20px_rgba(168,85,247,0.18)]">
            <Image
                src="/0699f3fd-7163-43a9-a1d9-97e89bf1a5bc.png"
                alt="Aegis logo"
                fill
                sizes="40px"
                className="object-contain"
                priority
            />
        </div>
        <span className="text-[15px] sm:text-lg">AEGIS</span>
    </div>
);
