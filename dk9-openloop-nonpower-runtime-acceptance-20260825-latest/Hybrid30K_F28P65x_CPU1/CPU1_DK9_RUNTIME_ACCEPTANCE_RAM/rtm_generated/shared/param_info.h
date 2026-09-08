#ifndef RTM_PARAM_INFO_H_
#define RTM_PARAM_INFO_H_

#include <stdint.h>

#define RTM_PARAM_SCHEMA_VERSION     5U
#define RTM_PARAM_GENERATOR_VERSION  12U
#define RTM_PARAM_INPUT_CRC32        0x52F7B39FUL
#define RTM_PARAM_FUNCTIONAL_CRC32   0xBC32F824UL
#define RTM_PARAM_MODEL_ID           0x5307U
#define RTM_PARAM_COUNT              245U

typedef struct
{
    uint16_t uiSchemaVersion;
    uint16_t uiGeneratorVersion;
    uint16_t uiModelId;
    uint16_t uiParamCount;
    uint32_t ulInputCrc32;
    uint32_t ulFunctionalCrc32;
} RTM_PARAM_INFO_TYPE;

extern const RTM_PARAM_INFO_TYPE g_stRtmParamInfo;

#endif
