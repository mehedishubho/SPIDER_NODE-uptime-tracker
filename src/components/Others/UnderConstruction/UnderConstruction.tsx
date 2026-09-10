'use client';

import { motion } from "motion/react";
import { Wrench01Icon as Wrench, Clock01Icon as Clock, Settings01Icon as Construction } from "hugeicons-react";

export default function UnderConstruction() {
  return (
    <div className="min-h-screen bg-linear-to-br from-surface-deep to-surface-raised flex items-center justify-center p-4 py-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="text-center max-w-2xl mx-auto"
      >
        {/* Animated Construction Icon */}
        <motion.div
          animate={{ 
            rotate: [0, -10, 10, -10, 0],
            y: [0, -10, 0]
          }}
          transition={{ 
            duration: 2,
            repeat: Infinity,
            repeatType: "reverse"
          }}
          className="mb-8"
        >
          <Construction className="w-24 h-24 text-accent-gold mx-auto" />
        </motion.div>

        {/* Title */}
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="font-playfair text-4xl md:text-6xl font-bold text-foreground-bright mb-6"
        >
          Under Construction
        </motion.h1>

        {/* Message */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="text-lg md:text-xl text-foreground-bright/80 mb-8 leading-relaxed"
        >
          We&lsquo;re working hard to bring you something amazing! 
          <br />
          This page will be available soon.
        </motion.p>

        {/* Progress Indicators */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.6 }}
          className="flex justify-center items-center gap-6 mb-8"
        >
          <div className="flex items-center gap-2 text-foreground-bright/70">
            <Wrench className="w-5 h-5 text-accent-gold" />
            <span className="text-sm">Building</span>
          </div>
          <div className="flex items-center gap-2 text-foreground-bright/70">
            <Clock className="w-5 h-5 text-accent-gold" />
            <span className="text-sm">Coming Soon</span>
          </div>
        </motion.div>

        {/* Animated Progress Bar */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.8 }}
          className="mb-8"
        >
          <div className="w-full bg-surface-raised rounded-full h-3 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: "65%" }}
              transition={{ 
                duration: 2,
                delay: 1,
                ease: "easeOut"
              }}
              className="h-full bg-linear-to-r from-accent-gold to-accent-gold-deep rounded-full"
            />
          </div>
          <p className="text-foreground-bright/60 text-sm mt-2">65% Complete</p>
        </motion.div>

        {/* Contact Info */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 1 }}
          className="bg-surface-raised border border-accent-gold/20 rounded-2xl p-6 max-w-md mx-auto"
        >
          <p className="text-foreground-bright mb-4">
            Need immediate assistance?
          </p>
          <a
            href="mailto:info@zerophotography.com"
            className="inline-flex items-center bg-accent-gold hover:bg-accent-gold-deep text-surface-deep px-6 py-3 rounded-full font-semibold transition-all hover:scale-105"
          >
            Contact Us
          </a>
        </motion.div>

        {/* Floating Elements */}
        <motion.div
          animate={{ 
            y: [0, -20, 0],
            opacity: [0.5, 1, 0.5]
          }}
          transition={{ 
            duration: 3,
            repeat: Infinity,
            repeatType: "reverse"
          }}
          className="absolute top-1/4 left-1/4 text-accent-gold/20"
        >
          <Wrench className="w-8 h-8" />
        </motion.div>
        <motion.div
          animate={{ 
            y: [0, 20, 0],
            opacity: [0.3, 0.7, 0.3]
          }}
          transition={{ 
            duration: 4,
            repeat: Infinity,
            repeatType: "reverse",
            delay: 1
          }}
          className="absolute bottom-1/4 right-1/4 text-accent-gold/20"
        >
          <Construction className="w-6 h-6" />
        </motion.div>
      </motion.div>
    </div>
  );
}