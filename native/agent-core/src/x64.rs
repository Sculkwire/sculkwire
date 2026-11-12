//! An x64 instruction length decoder, enough for the prologues of hooked functions and for
//! validating RIP-relative references in the game's `.text`.
//!
//! It is not a disassembler: it reports the length, whether the instruction has a RIP-relative memory
//! operand (and where its `disp32` sits), and whether it is a relative branch, which cannot be copied
//! into a trampoline as-is. Everything else is ignored. VEX/EVEX and three-byte opcodes are refused,
//! which is correct for the prologues this is used on and makes a wrong length impossible: an
//! undecodable byte yields `None`, and every caller treats that as "do not touch this function".

/// One decoded instruction.
#[derive(Clone, Copy, Debug, Default)]
pub struct Insn {
    /// Instruction length in bytes.
    pub len: usize,
    /// The instruction has a RIP-relative memory operand.
    pub rip: bool,
    /// Byte offset of that `disp32` inside the instruction.
    pub disp_off: usize,
    /// Width of a relative branch/call displacement in bytes (0 when the instruction is not one).
    pub rel: u8,
    /// Primary opcode.
    pub opcode: u8,
    /// Second opcode byte for `0F xx`.
    pub opcode2: u8,
}

/// Decodes the instruction at `bytes`, reading at most `max` bytes.
///
/// # Safety
/// `bytes` must point at `max` readable bytes.
pub unsafe fn decode(bytes: *const u8, max: usize) -> Option<Insn> {
    if bytes.is_null() || max == 0 {
        return None;
    }
    let read = |index: usize| -> Option<u8> {
        if index < max {
            Some(core::ptr::read_volatile(bytes.add(index)))
        } else {
            None
        }
    };
    let mut insn = Insn::default();
    let mut i = 0usize;
    let mut rexw = false;
    let mut opsz = false;
    let mut addrsz = false;

    loop {
        let byte = read(i)?;
        match byte {
            0x66 => opsz = true,
            0x67 => addrsz = true,
            0xF0 | 0xF2 | 0xF3 | 0x2E | 0x36 | 0x3E | 0x26 | 0x64 | 0x65 => {}
            0x40..=0x4F => rexw = byte & 8 != 0,
            _ => break,
        }
        i += 1;
    }

    let op = read(i)?;
    i += 1;
    insn.opcode = op;
    let mut modrm = false;
    let mut imm = 0usize;
    let mut rel = 0u8;

    if op == 0x0F {
        let op2 = read(i)?;
        i += 1;
        insn.opcode2 = op2;
        if op2 == 0x38 || op2 == 0x3A {
            return None; // three-byte escape: not needed, never produced by a prologue
        }
        match op2 {
            0x05 | 0x06 | 0x07 | 0x08 | 0x09 | 0x0B | 0x0E | 0x30 | 0x31 | 0x32 | 0x33 | 0x34 | 0x35
            | 0x37 | 0x77 | 0xA2 | 0xAA | 0xC8..=0xCF => {}
            0x80..=0x8F => rel = 4,
            _ => {
                modrm = true;
                if (0x70..=0x73).contains(&op2)
                    || matches!(op2, 0xBA | 0xA4 | 0xAC | 0xC2 | 0xC4 | 0xC5 | 0xC6)
                {
                    imm = 1;
                }
            }
        }
    } else if op < 0x40 {
        let low = op & 7;
        if matches!(op, 0x27 | 0x2F | 0x37 | 0x3F | 0x06 | 0x07 | 0x0E | 0x16 | 0x17 | 0x1E | 0x1F) {
            return None;
        }
        match low {
            0..=3 => modrm = true,
            4 => imm = 1,
            5 => imm = if opsz { 2 } else { 4 },
            _ => return None,
        }
    } else if (0x50..=0x5F).contains(&op) {
        // push/pop register
    } else if matches!(op, 0x60 | 0x61 | 0x62) {
        return None; // invalid / EVEX
    } else if op == 0x63 {
        modrm = true;
    } else if op == 0x68 {
        imm = 4;
    } else if op == 0x69 {
        modrm = true;
        imm = if opsz { 2 } else { 4 };
    } else if op == 0x6A {
        imm = 1;
    } else if op == 0x6B {
        modrm = true;
        imm = 1;
    } else if (0x6C..=0x6F).contains(&op) {
        // string ops
    } else if (0x70..=0x7F).contains(&op) {
        rel = 1;
    } else if (0x80..=0x8F).contains(&op) {
        modrm = true;
        match op {
            0x80 | 0x83 => imm = 1,
            0x81 => imm = if opsz { 2 } else { 4 },
            0x82 => return None,
            _ => {}
        }
    } else if (0x90..=0x9F).contains(&op) {
        // nop / xchg / cwde / cdq / pushf / popf / sahf / lahf
    } else if (0xA0..=0xA3).contains(&op) {
        imm = if addrsz { 4 } else { 8 };
    } else if op == 0xA8 {
        imm = 1;
    } else if op == 0xA9 {
        imm = if opsz { 2 } else { 4 };
    } else if (0xA4..=0xAF).contains(&op) {
        // string / stos / lods / scas
    } else if (0xB0..=0xB7).contains(&op) {
        imm = 1;
    } else if (0xB8..=0xBF).contains(&op) {
        imm = if rexw {
            8
        } else if opsz {
            2
        } else {
            4
        };
    } else if op == 0xC0 || op == 0xC1 {
        modrm = true;
        imm = 1;
    } else if op == 0xC2 {
        imm = 2;
    } else if op == 0xC3 {
        // ret
    } else if op == 0xC4 || op == 0xC5 {
        return None; // VEX
    } else if op == 0xC6 {
        modrm = true;
        imm = 1;
    } else if op == 0xC7 {
        modrm = true;
        imm = if opsz { 2 } else { 4 };
    } else if op == 0xC8 {
        imm = 2;
    } else if op == 0xC9 || (0xCB..=0xCF).contains(&op) {
        // leave / retf / int3 / int / into / iret
    } else if op == 0xCA {
        imm = 2;
    } else if (0xD0..=0xD3).contains(&op) {
        modrm = true;
    } else if op == 0xD4 || op == 0xD5 {
        imm = 1;
    } else if op == 0xD6 || op == 0xD7 {
        // invalid / xlat
    } else if (0xD8..=0xDF).contains(&op) {
        modrm = true;
    } else if (0xE0..=0xE3).contains(&op) {
        rel = 1;
    } else if (0xE4..=0xE7).contains(&op) {
        imm = 1;
    } else if op == 0xE8 || op == 0xE9 {
        rel = 4;
    } else if op == 0xEA {
        return None;
    } else if op == 0xEB {
        rel = 1;
    } else if (0xEC..=0xEF).contains(&op) {
        // in / out dx
    } else if op == 0xF1 || op == 0xF4 || op == 0xF5 || op >= 0xF8 {
        // int1 / hlt / cmc / flags
    } else if op == 0xF6 || op == 0xF7 {
        modrm = true;
    } else if op == 0xFE || op == 0xFF {
        modrm = true;
    } else {
        return None;
    }

    if modrm {
        let m = read(i)?;
        i += 1;
        let mode = m >> 6;
        let reg = (m >> 3) & 7;
        let rm = m & 7;
        if mode != 3 && rm == 4 {
            let sib = read(i)?;
            i += 1;
            if mode == 0 && (sib & 7) == 5 && !addrsz {
                i += 4;
            }
        }
        if mode == 0 && rm == 5 {
            if !addrsz {
                insn.rip = true;
                insn.disp_off = i;
            }
            i += 4;
        } else if mode == 1 {
            i += 1;
        } else if mode == 2 {
            i += 4;
        }
        // Group 3 (F6/F7) carries an immediate only for the /0 and /1 encodings.
        if (op == 0xF6 || op == 0xF7) && imm == 0 && reg < 2 {
            imm = if op == 0xF6 {
                1
            } else if opsz {
                2
            } else {
                4
            };
        }
    }
    insn.rel = rel;
    i += imm;
    if i > max || i > 15 {
        return None;
    }
    insn.len = i;
    Some(insn)
}
