import { Link as LinkIcon } from "lucide-react";

export const Logo = () => (
    <div className="flex items-center gap-2 font-bold text-lg tracking-tight text-white select-none cursor-pointer">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-300 via-violet-500 to-fuchsia-600 flex items-center justify-center text-black shadow-[0_0_20px_rgba(168,85,247,0.45)]">
            <LinkIcon className="w-4 h-4" />
        </div>
        <span>AEGIS</span>
    </div>
);
