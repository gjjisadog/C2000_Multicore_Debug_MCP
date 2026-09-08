################################################################################
# Automatically-generated file. Do not edit!
################################################################################

SHELL = cmd.exe

# Each subdirectory must supply rules for building sources it contributes
platform/utils/06_ramp/src/utils_ramp.obj: C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/platform/utils/06_ramp/src/utils_ramp.c $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'C2000 Compiler: "$<"'
	"D:/ccs21.0/ccs/tools/compiler/ti-cgt-c2000_25.11.1.LTS/bin/cl2000" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu2/board.opt" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu2/c2000ware_libraries.opt" --cmd_file="ccsIncludes.opt"  -v28 -ml -mt --cla_support=cla2 --float_support=fpu64 --isr_save_vcu_regs=on --tmu_support=tmu1 --vcu_support=vcrc -O2 --define=RAM --define=HYBRID30K_DK9_SAFE_VALIDATION --define=STACK_WATCH_ENABLE --define=CORE_COMM_DEBUG_CPU2_PRELOADED --define=HYBRID30K_DK9_CE_PRELOADED --define=CORE_COMM_MSGRAM_PARITY_INJECT_ENABLE --define=CORE_COMM_RAM_TEST_INJECT_ENABLE --define=DEBUG --define=BOARD_PROFILE_DK9_LAUNCHXL --define=CPU2 --diag_suppress=10063 --diag_warning=225 --diag_wrap=off --display_error_number --gen_func_subsections=on --abi=eabi --preproc_with_compile --preproc_dependency="platform/utils/06_ramp/src/$(basename $(<F)).d_raw" --obj_directory="platform/utils/06_ramp/src" $(GEN_OPTS__FLAG) "$<"
	@echo ' '


