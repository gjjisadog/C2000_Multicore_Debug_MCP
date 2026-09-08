################################################################################
# Automatically-generated file. Do not edit!
################################################################################

SHELL = cmd.exe

# Each subdirectory must supply rules for building sources it contributes
app/logic/03_protection/src/logic_protection.obj: C:/Users/11981/Documents/Hybrid_Platform/.worktrees/dk9-mil-hw-rework-20260902/app/logic/03_protection/src/logic_protection.c $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'C2000 Compiler: "$<"'
	"D:/ccs21.0/ccs/tools/compiler/ti-cgt-c2000_25.11.1.LTS/bin/cl2000" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/dk9-mil-hw-rework-20260902/project/hybrid30k/board/generated/dk9_launchxl/cpu2/board.opt" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/dk9-mil-hw-rework-20260902/project/hybrid30k/board/generated/dk9_launchxl/cpu2/c2000ware_libraries.opt" --cmd_file="ccsIncludes.opt"  -v28 -ml -mt --cla_support=cla2 --float_support=fpu64 --isr_save_vcu_regs=on --tmu_support=tmu1 --vcu_support=vcrc -O2 --define=_FLASH --define=BOARD_PROFILE_DK9_LAUNCHXL --define=DEBUG --define=CPU2 --diag_suppress=10063 --diag_warning=225 --diag_wrap=off --display_error_number --gen_func_subsections=on --abi=eabi --preproc_with_compile --preproc_dependency="app/logic/03_protection/src/$(basename $(<F)).d_raw" --include_path="C:/Users/11981/Documents/C2000_Debug_MCP/ccs_ws_dk9_rework_20260902_mainline/Hybrid30K_CPU2_DK9_LAUNCHXL/CPU2_FLASH/syscfg" --obj_directory="app/logic/03_protection/src" $(GEN_OPTS__FLAG) "$<"
	@echo ' '


