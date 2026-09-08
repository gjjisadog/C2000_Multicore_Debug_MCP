################################################################################
# Automatically-generated file. Do not edit!
################################################################################

SHELL = cmd.exe

# Each subdirectory must supply rules for building sources it contributes
platform/utils/02_filter/src/utils_filter.obj: C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/platform/utils/02_filter/src/utils_filter.c $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'C2000 Compiler: "$<"'
	"D:/ccs21.0/ccs/tools/compiler/ti-cgt-c2000_25.11.1.LTS/bin/cl2000" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu1/board.opt" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu1/c2000ware_libraries.opt" --cmd_file="ccsIncludes.opt"  -v28 -ml -mt --cla_support=cla2 --float_support=fpu64 --isr_save_vcu_regs=off --tmu_support=tmu1 --vcu_support=vcrc -O2 --define=RAM --define=HYBRID30K_DK9_CE_PRELOADED --define=HYBRID30K_DK9_MEASUREMENT_SYNTHETIC --define=CORE_COMM_RAM_TEST_INJECT_ENABLE --define=CTRL_CURRLOOP_CLA_RUN_VALIDATED --define=STACK_WATCH_ENABLE --define=HYBRID30K_DK9_RUNTIME_ACCEPTANCE --define=DEBUG --define=BOARD_PROFILE_DK9_LAUNCHXL --define=CPU1 --diag_suppress=10063 --diag_warning=225 --diag_wrap=off --display_error_number --gen_func_subsections=on --abi=eabi --preproc_with_compile --preproc_dependency="platform/utils/02_filter/src/$(basename $(<F)).d_raw" --obj_directory="platform/utils/02_filter/src" $(GEN_OPTS__FLAG) "$<"
	@echo ' '

platform/utils/02_filter/src/utils_filter_cla.obj: C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/platform/utils/02_filter/src/utils_filter_cla.cla $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'C2000 Compiler: "$<"'
	"D:/ccs21.0/ccs/tools/compiler/ti-cgt-c2000_25.11.1.LTS/bin/cl2000" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu1/board.opt" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu1/c2000ware_libraries.opt" --cmd_file="ccsIncludes.opt"  -v28 -ml -mt --cla_support=cla2 --float_support=fpu64 --isr_save_vcu_regs=off --tmu_support=tmu1 --vcu_support=vcrc -O2 --define=RAM --define=HYBRID30K_DK9_CE_PRELOADED --define=HYBRID30K_DK9_MEASUREMENT_SYNTHETIC --define=CORE_COMM_RAM_TEST_INJECT_ENABLE --define=CTRL_CURRLOOP_CLA_RUN_VALIDATED --define=STACK_WATCH_ENABLE --define=HYBRID30K_DK9_RUNTIME_ACCEPTANCE --define=DEBUG --define=BOARD_PROFILE_DK9_LAUNCHXL --define=CPU1 --diag_suppress=10063 --diag_warning=225 --diag_wrap=off --display_error_number --gen_func_subsections=on --abi=eabi --preproc_with_compile --preproc_dependency="platform/utils/02_filter/src/$(basename $(<F)).d_raw" --obj_directory="platform/utils/02_filter/src" $(GEN_OPTS__FLAG) "$<"
	@echo ' '

platform/utils/02_filter/src/utils_filter_coeff.obj: C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/platform/utils/02_filter/src/utils_filter_coeff.c $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'C2000 Compiler: "$<"'
	"D:/ccs21.0/ccs/tools/compiler/ti-cgt-c2000_25.11.1.LTS/bin/cl2000" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu1/board.opt" --cmd_file="C:/Users/11981/Documents/Hybrid_Platform/.worktrees/codex-dk9-3p3w-runtime-acceptance/project/hybrid30k/board/generated/dk9_launchxl/cpu1/c2000ware_libraries.opt" --cmd_file="ccsIncludes.opt"  -v28 -ml -mt --cla_support=cla2 --float_support=fpu64 --isr_save_vcu_regs=off --tmu_support=tmu1 --vcu_support=vcrc -O2 --define=RAM --define=HYBRID30K_DK9_CE_PRELOADED --define=HYBRID30K_DK9_MEASUREMENT_SYNTHETIC --define=CORE_COMM_RAM_TEST_INJECT_ENABLE --define=CTRL_CURRLOOP_CLA_RUN_VALIDATED --define=STACK_WATCH_ENABLE --define=HYBRID30K_DK9_RUNTIME_ACCEPTANCE --define=DEBUG --define=BOARD_PROFILE_DK9_LAUNCHXL --define=CPU1 --diag_suppress=10063 --diag_warning=225 --diag_wrap=off --display_error_number --gen_func_subsections=on --abi=eabi --preproc_with_compile --preproc_dependency="platform/utils/02_filter/src/$(basename $(<F)).d_raw" --obj_directory="platform/utils/02_filter/src" $(GEN_OPTS__FLAG) "$<"
	@echo ' '


