"use client";

import { useEffect, useRef, useState } from 'react';
import { useMotionValue, animate, useInView } from 'framer-motion';

interface CountingNumberProps {
    value: number;
    suffix?: string;
}

export const CountingNumber = ({ value, suffix = "" }: CountingNumberProps) => {
    const count = useMotionValue(0);
    const [display, setDisplay] = useState("0");
    const ref = useRef(null);
    const isInView = useInView(ref, { once: true, margin: "-50px" });

    useEffect(() => {
        const unsubscribe = count.on("change", (latest) => {
            setDisplay(Math.round(latest).toLocaleString());
        });
        if (isInView) {
            animate(count, value, { duration: 2, ease: "easeOut", delay: 0.2 });
        }
        return () => unsubscribe();
    }, [isInView, value, count]);

    return (
        <span ref={ref}>
            {display}
            {suffix}
        </span>
    );
};
