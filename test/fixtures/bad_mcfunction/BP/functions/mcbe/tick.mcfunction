# runs every tick
execute if entity @e[type=mcbe:test_mob] run function mcbe/heal
notacommand @s
execute as @a run bogus hello
function mcbe/missing
